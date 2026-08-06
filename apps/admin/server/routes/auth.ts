import { Router, type RequestHandler } from "express";
import { loginRequestSchema } from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import {
  clearSessionCookie,
  readCookie,
  setSessionCookie,
  type SessionCookiePolicy,
} from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
  getAuthenticatedSessionToken,
  sendAuthServiceError,
} from "../auth/middleware.ts";

export interface AuthRouterDependencies {
  service: Pick<
    AuthService,
    | "login"
    | "bootstrapSession"
    | "resolveSession"
    | "requirePermission"
    | "logout"
  >;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

export function createAuthRouter({
  service,
  cookiePolicy,
  sameOrigin,
}: AuthRouterDependencies) {
  const router = Router();

  router.post("/login", sameOrigin, async (request, response) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({
        error: "Check the sign-in form and try again.",
        code: "VALIDATION_FAILED",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    try {
      const result = await service.login({
        normalizedEmail: parsed.data.email,
        password: parsed.data.password,
        networkIdentifier: request.socket.remoteAddress ?? "unknown",
        previousSessionToken: readCookie(
          request.get("cookie"),
          cookiePolicy.name,
        ),
      });
      setSessionCookie(response, cookiePolicy, result.sessionToken);
      response.status(200).json(result.session);
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  });

  router.get("/session", async (request, response) => {
    const sessionToken = readCookie(request.get("cookie"), cookiePolicy.name);
    try {
      const result = await service.bootstrapSession(sessionToken);
      response.status(200).json(result.session);
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  });

  router.post(
    "/logout",
    sameOrigin,
    createRequireSession(service, cookiePolicy, { csrf: true }),
    async (_request, response) => {
      try {
        await service.logout(
          getAuthenticatedActor(response),
          getAuthenticatedSessionToken(response),
        );
        clearSessionCookie(response, cookiePolicy);
        response.status(204).end();
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
      }
    },
  );

  return router;
}
