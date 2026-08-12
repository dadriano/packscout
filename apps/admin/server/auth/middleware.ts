import type { RequestHandler, Response } from "express";
import type { OperatorPermission } from "@packscout/contracts";
import {
  AuthServiceError,
  type AuthenticatedActor,
  type AuthService,
} from "@packscout/services";
import {
  clearSessionCookie,
  readCookie,
  type SessionCookiePolicy,
} from "./cookies.ts";

interface AuthLocals {
  authActor: AuthenticatedActor;
  authSessionToken: string;
}

export function sendAuthServiceError(
  response: Response,
  error: unknown,
  cookiePolicy?: SessionCookiePolicy,
): void {
  if (error instanceof AuthServiceError) {
    if (error.code === "AUTH_REQUIRED" && cookiePolicy) {
      clearSessionCookie(response, cookiePolicy);
    }
    if (error.code === "RATE_LIMITED" && error.retryAt) {
      response.setHeader(
        "Retry-After",
        Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1_000)),
      );
    }
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  response.status(503).json({
    error: "PackScout Admin is temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

export function createRequireSession(
  service: Pick<AuthService, "resolveSession" | "requirePermission">,
  cookiePolicy: SessionCookiePolicy,
  options: { csrf?: boolean; permission?: OperatorPermission } = {},
): RequestHandler {
  return async (request, response, next) => {
    const sessionToken = readCookie(request.get("cookie"), cookiePolicy.name);
    const csrfToken = options.csrf ? request.get("x-csrf-token") : undefined;
    if (options.csrf && !csrfToken) {
      response.status(403).json({
        error: "The request could not be verified.",
        code: "FORBIDDEN",
      });
      return;
    }
    try {
      const actor = await service.resolveSession({ sessionToken, csrfToken });
      if (options.permission) service.requirePermission(actor, options.permission);
      const locals = response.locals as AuthLocals;
      locals.authActor = actor;
      locals.authSessionToken = sessionToken as string;
      next();
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  };
}

export function getAuthenticatedActor(response: Response): AuthenticatedActor {
  return (response.locals as AuthLocals).authActor;
}

export function getAuthenticatedSessionToken(response: Response): string {
  return (response.locals as AuthLocals).authSessionToken;
}
